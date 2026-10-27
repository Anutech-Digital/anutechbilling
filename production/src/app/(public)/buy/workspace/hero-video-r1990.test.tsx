// @vitest-environment jsdom
/**
 * R-1990 (Pardeep, 26 Oct 2026): a slow-motion background video behind the /buy/workspace hero —
 * muted, looping, playsinline, playbackRate 0.5 — under a 10% black layer, the hero content on
 * top, the price card white. Reduced motion or Save-Data → the poster only. The file is the
 * Pexels clip Pardeep chose (public/media/README.md: source + license).
 *
 * Contrast (AA): measured on the clip with ffmpeg (left 55% of the frame, 1 fps): with only the
 * 10% black layer, dark text sits on backgrounds from 1.04:1 (worst 5%) to 4.26:1 (median) —
 * fails AA. R-1990 put the text on a light paper panel; R-2018 (27 Oct, Pardeep) replaced it with a
 * dark ink layer and white text straight on the video — layer, colours and AA are now checked in
 * hero-dark-r2018.test.tsx.
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

  it("video: muted, autoplay, loop, playsinline, poster; slowed to 0.5 when it loads; dark ink layer (R-2018); no sound", () => {
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
    expect(hero().querySelector("[data-testid=hero-dim]")?.className).toMatch(/bg-ink\/80/);
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

  it("content on top: no panel behind the text (R-2018), the price card stays white, the hero has no own background", () => {
    render(<BuyWorkspaceClient paymentMode="simulation" brand={null} />);
    expect(hero().className).not.toMatch(/\bbg-(paper|white)\b/);
    expect(screen.getByTestId("hero-text").className).not.toMatch(/bg-paper/);
    expect(screen.getByRole("heading", { level: 2, name: "Your price" }).closest("div.bg-white")).toBeTruthy();
  });
});
