// @vitest-environment jsdom
/**
 * R-1990 (Pardeep, 26 Oct 2026): a slow-motion background video behind the /buy/workspace hero —
 * muted, looping, playsinline, playbackRate 0.5 — under a 10% black layer, the hero content on
 * top, the price card white. Reduced motion or Save-Data → the poster only. The file is the
 * Pexels clip Pardeep chose (public/media/README.md: source + license).
 *
 * Contrast (AA): measured on the clip with ffmpeg (left 55% of the frame, 1 fps): with only the
 * 10% black layer, dark text sits on backgrounds from 1.04:1 (worst 5%) to 4.26:1 (median) —
 * fails AA. So the hero text sits on a light paper panel (85% opaque): its darkest background
 * through the panel (the darkest pixel of the clip) has relative luminance 0.664; the hero text
 * colours are ink and ink-2 (ink-3 would need 0.756 — not used in the hero text), checked below.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }));

import { BuyWorkspaceClient } from "./buy-workspace-client";
import { HERO_VIDEO } from "./_parts/hero";

const PUBLIC = join(__dirname, "..", "..", "..", "..", "..", "public");
let reduce = false;
let saveData = false;

beforeEach(() => {
  reduce = false; saveData = false;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  window.matchMedia = ((q: string) => ({ matches: q.includes("reduce") ? reduce : false, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  Object.defineProperty(navigator, "connection", { value: { get saveData() { return saveData; } }, configurable: true });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const hero = () => document.querySelector("[data-testid=hero]") as HTMLElement;

describe("R-1990 hero background video", () => {
  it("the files exist, the clip is small (under 3 MB) and its source + license is written down", () => {
    expect(HERO_VIDEO).toEqual({ src: "/media/hero-workspace.mp4", poster: "/media/hero-workspace.jpg" });
    const mp4 = join(PUBLIC, "media", "hero-workspace.mp4");
    expect(existsSync(mp4)).toBe(true);
    expect(statSync(mp4).size).toBeLessThan(3 * 1024 * 1024);
    expect(existsSync(join(PUBLIC, "media", "hero-workspace.jpg"))).toBe(true);
    const readme = readFileSync(join(PUBLIC, "media", "README.md"), "utf8");
    expect(readme).toMatch(/pexels\.com\/video\/men-and-women-busy-working-on-their-computers-3251737/);
    expect(readme).toMatch(/fauxels/);
    expect(readme).toMatch(/Pexels License/);
  });

  it("video: muted, autoplay, loop, playsinline, poster; slowed to 0.5 when it loads; 10% black layer; no sound", () => {
    render(<BuyWorkspaceClient paymentMode="simulation" brand={null} />);
    const v = hero().querySelector("video") as HTMLVideoElement;
    expect(v).toBeTruthy();
    expect(v.muted).toBe(true);
    expect(v.autoplay).toBe(true);
    expect(v.loop).toBe(true);
    expect(v.hasAttribute("playsinline")).toBe(true);
    expect(v.getAttribute("poster")).toBe("/media/hero-workspace.jpg");
    expect(v.getAttribute("aria-hidden")).toBe("true");
    v.dispatchEvent(new Event("loadedmetadata"));
    expect(v.playbackRate).toBe(0.5);
    expect(hero().querySelector("[data-testid=hero-dim]")?.className).toMatch(/bg-black\/10/);
  });

  it("reduced motion → poster only, no video", () => {
    reduce = true;
    render(<BuyWorkspaceClient paymentMode="simulation" brand={null} />);
    expect(hero().querySelector("video")).toBeNull();
    expect(hero().querySelector("img[data-testid=hero-poster]")?.getAttribute("src")).toBe("/media/hero-workspace.jpg");
  });

  it("Save-Data → poster only", () => {
    saveData = true;
    render(<BuyWorkspaceClient paymentMode="simulation" brand={null} />);
    expect(hero().querySelector("video")).toBeNull();
    expect(hero().querySelector("img[data-testid=hero-poster]")).toBeTruthy();
  });

  it("content on top: the text on a light paper panel (AA), the price card stays white, the hero has no own background", () => {
    render(<BuyWorkspaceClient paymentMode="simulation" brand={null} />);
    expect(hero().className).not.toMatch(/\bbg-(paper|white)\b/);
    const panel = screen.getByTestId("hero-text");
    expect(panel.className).toMatch(/bg-paper\/85/);
    expect(panel.outerHTML).not.toMatch(/text-ink-3/);
    expect(screen.getByRole("heading", { level: 2, name: "Your price" }).closest("div.bg-white")).toBeTruthy();
  });

  it("AA: ink and ink-2 on the panel's darkest background pass 4.5:1; the amber headline (large text) passes 3:1", () => {
    const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const L = (h: string) => { const n = parseInt(h.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
    const worstBg = 0.664; // measured: darkest pixel of the clip through bg-paper/85 (see header)
    for (const ink of ["#1A1815", "#4F4A40"]) {
      expect((worstBg + 0.05) / (L(ink) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
    expect((worstBg + 0.05) / (L("#C2410C") + 0.05)).toBeGreaterThanOrEqual(3);
  });
});
