// @vitest-environment jsdom
/**
 * R-2187 (G-ZOHO audit, 31 Oct 2026): with Windows/macOS set to dark and no theme ever picked,
 * the app still opened LIGHT — ThemeProvider's defaultTheme was "light", so next-themes never
 * looked at prefers-color-scheme. Now: no stored choice → follow the OS (and follow it live when
 * it changes); an explicit Light/Dark choice in the header wins; "System" goes back to the OS.
 * The header toggle offers all three (System / Light / Dark) instead of a two-way flip.
 *
 * No flash of the wrong theme on load is next-themes' own blocking script (it reads the stored
 * choice / matchMedia before first paint); the Playwright card test e2e/cards/R-2187.spec.ts
 * checks the <html> class on the very first document load in a dark-scheme browser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, screen, fireEvent, waitFor } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let pathname = "/dashboard";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import { ThemeProvider, APP_SHELL_SEGMENTS, isAppShellPath } from "@/components/providers/theme-provider";
import { ThemeMenu } from "@/components/layout/theme-menu";

type Listener = (e: MediaQueryListEvent) => void;

/** A matchMedia whose "(prefers-color-scheme: dark)" answer the test controls and can change. */
function mockColorScheme(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<Listener>();
  const mql = (query: string) => ({
    get matches() { return query.includes("dark") ? dark : false; },
    media: query,
    onchange: null,
    addListener: (l: Listener) => listeners.add(l),
    removeListener: (l: Listener) => listeners.delete(l),
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
    dispatchEvent: () => true,
  });
  window.matchMedia = vi.fn(mql) as unknown as typeof window.matchMedia;
  return {
    setDark(next: boolean) {
      dark = next;
      for (const l of listeners) l({ matches: next, media: "(prefers-color-scheme: dark)" } as MediaQueryListEvent);
    },
  };
}

const html = () => document.documentElement;

/** Node 22+'s own (flag-gated) localStorage shadows jsdom's — give the window a plain in-memory one. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}
const localStorage = memoryStorage();
Object.defineProperty(window, "localStorage", { value: localStorage, configurable: true });

beforeEach(() => {
  localStorage.clear();
  pathname = "/dashboard";
  html().className = "";
  html().removeAttribute("style");
});
afterEach(() => cleanup());

describe("R-2187 — theme follows the OS until the user picks one", () => {
  it("no stored choice + OS dark → <html> gets the dark class", () => {
    mockColorScheme(true);
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(html().classList.contains("dark")).toBe(true);
  });

  it("no stored choice + OS light → light", () => {
    mockColorScheme(false);
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(html().classList.contains("dark")).toBe(false);
    expect(html().classList.contains("light")).toBe(true);
  });

  it("a stored explicit 'light' wins over an OS in dark", () => {
    mockColorScheme(true);
    localStorage.setItem("theme", "light");
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(html().classList.contains("dark")).toBe(false);
  });

  it("a stored explicit 'dark' wins over an OS in light", () => {
    mockColorScheme(false);
    localStorage.setItem("theme", "dark");
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(html().classList.contains("dark")).toBe(true);
  });

  it("'system' follows a live OS change event", () => {
    const os = mockColorScheme(false);
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(html().classList.contains("dark")).toBe(false);
    act(() => os.setDark(true));
    expect(html().classList.contains("dark")).toBe(true);
    act(() => os.setDark(false));
    expect(html().classList.contains("dark")).toBe(false);
  });

});

/* Review finding (R-2187): the website, buy/checkout, login and public links are built light only
   (hard-coded white panels next to theme-token text) and have no theme control — an OS in dark
   mode must not turn them dark. Only the signed-in app follows the OS / the stored choice. */
describe("R-2187 — pages outside the signed-in app stay light", () => {
  it.each(["/buy/support", "/login", "/checkout", "/quote/abc", "/", "/learn"])(
    "%s with OS dark (and even a stored 'dark') → light",
    (path) => {
      pathname = path;
      mockColorScheme(true);
      localStorage.setItem("theme", "dark");
      render(<ThemeProvider><div /></ThemeProvider>);
      expect(html().classList.contains("dark")).toBe(false);
    },
  );

  it("app pages are recognised by their first segment only", () => {
    expect(isAppShellPath("/invoices/INV-1")).toBe(true);
    expect(isAppShellPath("/settings")).toBe(true);
    expect(isAppShellPath("/quote/abc")).toBe(false); // public quote link, not /quotes
    expect(isAppShellPath("/")).toBe(false);
    expect(isAppShellPath(null)).toBe(false);
  });

  it("APP_SHELL_SEGMENTS is exactly the folders of src/app/(app) — a new app section is never left light-only", () => {
    const dirs = readdirSync(join(process.cwd(), "src/app/(app)"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("("))
      .map((e) => e.name)
      .sort();
    expect([...APP_SHELL_SEGMENTS].sort()).toEqual(dirs);
  });
});

describe("R-2187 — header toggle offers System / Light / Dark", () => {
  /* Radix opens a menu on keyboard Enter (jsdom does not model its pointer events). */
  const openMenu = () => fireEvent.keyDown(screen.getByRole("button", { name: /theme/i }), { key: "Enter" });

  it("lists the three choices, ticks the current one and stores the pick", async () => {
    mockColorScheme(true);
    render(<ThemeProvider><ThemeMenu /></ThemeProvider>);
    openMenu();
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent?.trim())).toEqual(["System", "Light", "Dark"]);
    expect(screen.getByRole("menuitemradio", { name: "System" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Light" }));
    expect(localStorage.getItem("theme")).toBe("light");
    expect(html().classList.contains("dark")).toBe(false);

    await waitFor(() => expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0)); // picking closes the menu
    openMenu();
    const system = await screen.findByRole("menuitemradio", { name: "System" });
    expect(screen.getByRole("menuitemradio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(system);
    expect(localStorage.getItem("theme")).toBe("system");
    expect(html().classList.contains("dark")).toBe(true);
  });

  it("topbar uses the shared ThemeMenu on desktop and the same three choices in the phone More menu", () => {
    const topbar = readFileSync(join(process.cwd(), "src/components/layout/topbar.tsx"), "utf8");
    expect(topbar).toMatch(/<ThemeMenu\b/);
    expect(topbar).toMatch(/<ThemeMenuItems\b/);
    // the old two-way flip is gone everywhere
    expect(topbar).not.toMatch(/setTheme\(resolvedTheme === "dark"/);
  });
});
