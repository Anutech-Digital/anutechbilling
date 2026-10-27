// @vitest-environment jsdom
/**
 * R-2010 (27 Oct 2026, G-DPDP): the ONE cookie-consent banner (DPDP Act 2023 / Rules 2025 —
 * free, specific, informed, unambiguous; withdrawing as easy as giving).
 *
 *   - names both purposes: "Necessary" (always on) and "Advertising measurement (Meta)", with
 *     what is shared (pages, purchase value, hashed email/phone, IP, browser) and a Privacy link;
 *   - two buttons of EQUAL weight ("Accept all" / "Only necessary"), no pre-ticked box;
 *   - the choice is recorded on our server (POST /api/public/consent);
 *   - "Cookie settings" in the footer reopens it; "Only necessary" then stops the Pixel at once
 *     (no reload) — and "Accept all" starts it at once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { ConsentBanner, CookieSettingsButton } from "@/site/components/chrome/ConsentBanner";
import { CONSENT_KEY, readConsent, NOTICE_VERSION } from "@/site/lib/consent";
import { MetaPixel, trackMeta } from "@/site/lib/meta-pixel";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } } as Storage;
}
const scripts = () => [...document.querySelectorAll('script[src*="connect.facebook.net"]')];
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

beforeEach(() => {
  delete window.fbq; delete window._fbq;
  Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
  document.head.innerHTML = "";
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("R-2010 consent banner — wording a visitor can understand", () => {
  it("a new visitor sees both purposes, Meta named, what is shared, and a Privacy link", () => {
    render(<ConsentBanner />);
    const dialog = screen.getByRole("region", { name: /cookie/i });
    // R-1971: the buy page has no dialog on load — the non-modal banner is a labelled region.
    expect(screen.queryByRole("dialog")).toBeNull();
    const text = dialog.textContent ?? "";
    expect(text).toContain("Necessary");
    expect(text).toContain("Advertising measurement (Meta)");
    for (const w of ["pages", "purchase value", "hashed", "IP address", "browser"]) expect(text).toContain(w);
    expect(text).not.toMatch(/Analytics cookies/);
    const privacy = screen.getByRole("link", { name: /privacy/i });
    expect(privacy.getAttribute("href")).toBe("/privacy-policy");
    expect(text).toContain("Cookie settings");
  });

  it("two buttons of equal weight, no pre-ticked box", () => {
    render(<ConsentBanner />);
    const all = screen.getByRole("button", { name: "Accept all" });
    const only = screen.getByRole("button", { name: "Only necessary" });
    expect(all.getAttribute("style")).toBe(only.getAttribute("style"));
    expect(all.className).toBe(only.className);
    expect(document.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(0);
  });

  it("a visitor who already chose sees no banner", () => {
    window.localStorage.setItem(CONSENT_KEY, "essential");
    render(<ConsentBanner />);
    expect(screen.queryByRole("region", { name: /cookie/i })).toBeNull();
  });
});

describe("R-2010 choosing, recording, reopening", () => {
  it("'Only necessary' → stored, banner gone, recorded on our server with the notice version", async () => {
    render(<ConsentBanner />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Only necessary" })); });
    expect(readConsent()).toBe("essential");
    expect(screen.queryByRole("region", { name: /cookie/i })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/public/consent");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ choice: "essential", noticeVersion: NOTICE_VERSION });
    expect(body.anonId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("'Cookie settings' reopens the banner, shows the current choice, and changing it sticks", async () => {
    window.localStorage.setItem(CONSENT_KEY, "essential");
    render(<><ConsentBanner /><CookieSettingsButton /></>);
    expect(screen.queryByRole("region", { name: /cookie/i })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cookie settings" })); });
    const dialog = screen.getByRole("region", { name: /cookie/i });
    // R-1971: the buy page has no dialog on load — the non-modal banner is a labelled region.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dialog.textContent).toContain("Your current choice: Only necessary");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Accept all" })); });
    expect(readConsent()).toBe("all");
    expect(screen.queryByRole("region", { name: /cookie/i })).toBeNull();
  });

  it("Escape closes a reopened banner without changing the choice", async () => {
    window.localStorage.setItem(CONSENT_KEY, "all");
    render(<><ConsentBanner /><CookieSettingsButton /></>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cookie settings" })); });
    fireEvent.keyDown(screen.getByRole("region", { name: /cookie/i }), { key: "Escape" });
    expect(screen.queryByRole("region", { name: /cookie/i })).toBeNull();
    expect(readConsent()).toBe("all");
  });
});

describe("R-2010 the Pixel follows the choice without a reload", () => {
  it("no choice → no Pixel; 'Accept all' in the banner → Meta's script loads at once", async () => {
    render(<><ConsentBanner /><MetaPixel pixelId="1234567890123456" /></>);
    expect(scripts()).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Accept all" })); });
    expect(scripts()).toHaveLength(1);
  });

  it("withdrawing via Cookie settings → Meta told to revoke, no further events sent", async () => {
    window.localStorage.setItem(CONSENT_KEY, "all");
    render(<><ConsentBanner /><CookieSettingsButton /><MetaPixel pixelId="1234567890123456" /></>);
    expect(window.fbq).toBeDefined();
    const calls: unknown[][] = [];
    const real = window.fbq!;
    const spy = Object.assign((...a: unknown[]) => { calls.push(a); }, real);
    window.fbq = spy as typeof real;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cookie settings" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Only necessary" })); });
    expect(calls).toContainEqual(["consent", "revoke"]);
    calls.length = 0;
    trackMeta("Purchase", { value: 1 });
    expect(calls).toEqual([]);
  });
});
