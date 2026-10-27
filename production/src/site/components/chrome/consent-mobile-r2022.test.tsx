// @vitest-environment jsdom
/**
 * R-2022 (27 Oct 2026, Pardeep's localhost check of R-2020 at 375x812): on a phone the consent
 * banner was a tall box (capped 34vh, scrolling inside) over "What do you need?", its two buttons
 * only reachable by scrolling INSIDE it, and one tap on "Only necessary" closed it AND selected
 * the "New Google Workspace" card underneath (intent=new) — the tap passed through.
 *
 *   - ≤640px: one short line + a "Details" expander holding the full R-2010 text (Meta named,
 *     what is shared, Privacy link — one tap away); both buttons always in view (never inside the
 *     scroll); the banner itself small.
 *   - The choice is made in the button's own click; the click stops there, and a second click the
 *     browser fires at the same spot right after the banner closes (the "ghost" tap) is swallowed.
 *   - Above 640px the banner is exactly the R-2010 one (same wording, full text, no Details).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { ConsentBanner } from "@/site/components/chrome/ConsentBanner";
import { readConsent } from "@/site/lib/consent";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } } as Storage;
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const css = () => Array.from(document.querySelectorAll("style")).map((s) => s.textContent ?? "").join("\n").replace(/\s+/g, " ");
const region = () => screen.getByRole("region", { name: /cookie/i });

/** Where a 375x812 phone draws the banner: above the 100px sticky bar, 12px gutters. */
const PHONE_RECT = { left: 12, right: 363, top: 560, bottom: 688, width: 351, height: 128, x: 12, y: 560, toJSON: () => ({}) } as DOMRect;

describe("R-2022 phone banner — short, buttons always visible, details one tap away", () => {
  it("shows one short line naming Meta, and a Details button that expands the full R-2010 text", () => {
    render(<ConsentBanner />);
    const r = region();
    expect(r.textContent).toContain("We use necessary cookies; with your OK, Meta measures our ads.");
    // jsdom applies no media query (it is "desktop" width), so the phone-only line is display:none here.
    const details = screen.getByRole("button", { name: "Details", hidden: true });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    const full = document.getElementById(details.getAttribute("aria-controls") ?? "");
    expect(full).toBeTruthy();
    expect(full!.textContent).toContain("Advertising measurement (Meta)");
    for (const w of ["pages", "purchase value", "hashed", "IP address", "browser"]) expect(full!.textContent).toContain(w);
    expect(r.getAttribute("data-expanded")).toBe("false");
    fireEvent.click(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(r.getAttribute("data-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: /privacy/i }).getAttribute("href")).toBe("/privacy-policy");
    // Details never decides anything.
    expect(readConsent()).toBeNull();
  });

  it("≤640px: full text hidden until Details, buttons outside the scroll, banner short", () => {
    render(<ConsentBanner />);
    const c = css();
    const phone = c.slice(c.indexOf("@media (max-width: 640px)"));
    expect(phone).toContain("@media (max-width: 640px)");
    expect(phone).toMatch(/\.consent-banner\[data-expanded="false"\] \.consent-full \{ display: none; \}/);
    expect(phone).toMatch(/\.consent-short \{ display: block;/);
    // the text area scrolls (when expanded); the buttons never do
    expect(c).toMatch(/\.consent-scroll \{[^}]*overflow-y: auto;/);
    expect(c).toMatch(/\.consent-actions \{[^}]*flex-shrink: 0;/);
    // the two buttons are NOT inside the scrolling part
    const scroll = document.querySelector(".consent-scroll")!;
    expect(scroll.contains(screen.getByRole("button", { name: "Only necessary" }))).toBe(false);
    expect(scroll.contains(screen.getByRole("button", { name: "Accept all" }))).toBe(false);
    // collapsed: no inner scrolling box any more (no 34vh cap with the buttons inside)
    expect(c).not.toContain("34vh");
  });

  it("above 640px nothing changes: no short line, no Details, full R-2010 text", () => {
    render(<ConsentBanner />);
    const c = css();
    const base = c.slice(0, c.indexOf("@media"));
    expect(base).toContain(".consent-banner { left: 22px; bottom: 22px; max-width: 400px; }");
    expect(base).toMatch(/\.consent-short \{ display: none; \}/);
    expect(base).not.toMatch(/consent-full \{ display: none/);
    expect(region().textContent).toContain("Cookies on this site");
    expect(region().textContent).toContain("Change this any time from Cookie settings at the bottom of the page.");
  });
});

describe("R-2022 no tap-through", () => {
  it("'Only necessary' stops its click there, and the ghost click at the same spot is swallowed", async () => {
    const under = vi.fn();
    const outer = vi.fn();
    render(
      <div onClick={outer}>
        <ConsentBanner />
        <button type="button" onClick={under}>New Google Workspace</button>
      </div>,
    );
    vi.spyOn(region(), "getBoundingClientRect").mockReturnValue(PHONE_RECT);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Only necessary" }), { clientX: 120, clientY: 660 }); });
    expect(readConsent()).toBe("essential");
    expect(screen.queryByRole("region", { name: /cookie/i })).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    // the browser's second (synthesised) click lands on what is now under the finger
    fireEvent.click(screen.getByRole("button", { name: "New Google Workspace" }), { clientX: 120, clientY: 660 });
    expect(under).not.toHaveBeenCalled();
  });

  it("a click elsewhere, or later, still works normally", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const under = vi.fn();
    render(<><ConsentBanner /><button type="button" onClick={under}>New Google Workspace</button></>);
    vi.spyOn(region(), "getBoundingClientRect").mockReturnValue(PHONE_RECT);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Accept all" }), { clientX: 300, clientY: 660 }); });
    fireEvent.click(screen.getByRole("button", { name: "New Google Workspace" }), { clientX: 200, clientY: 300 });
    expect(under).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1000); });
    fireEvent.click(screen.getByRole("button", { name: "New Google Workspace" }), { clientX: 300, clientY: 660 });
    expect(under).toHaveBeenCalledTimes(2);
  });
});
