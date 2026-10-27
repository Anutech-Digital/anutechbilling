// @vitest-environment jsdom
/**
 * R-2018 (Pardeep, 27 Oct 2026, reference screenshot): the /buy/workspace hero is a DARK video
 * background with white text straight on it — no light panel behind the text (reverses R-1990's
 * paper panel). The layer over the video is the brand ink as a left-to-right gradient: 80% across
 * the text column (left 60%), fading to 50% behind the white price card; below lg (text stacks
 * full-width) a flat 80%.
 *
 * Contrast (AA) — measured, not guessed: all 44 frames of the clip (4 fps) and the poster, brightest
 * pixel in the text column. The clip reaches pure white (L = 1.000; poster 0.952), so the worst
 * background is white under 80% ink. Every text colour below is checked against that.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, within } from "@testing-library/react";
import { GoogleWorkspaceWordmark } from "./_parts/wordmark";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }));

import { BuyWorkspaceClient, type CatalogItem } from "./buy-workspace-client";

/* R-2027: the page is priced only from the catalogue — the test passes one, as page.tsx does. */
const CATALOG: CatalogItem[] = [
  { id: "s", name: "Google Workspace Business Starter", msrp: 270, wholesale: 0, margin_pct: null, is_active: true, prices: { annual: { msrp: 270, wholesale: 0 }, monthly: { msrp: 325, wholesale: 0 } } },
  { id: "d", name: "Google Workspace Business Standard", msrp: 1080, wholesale: 0, margin_pct: null, is_active: true, prices: { annual: { msrp: 1080, wholesale: 0 }, monthly: { msrp: 1300, wholesale: 0 } } },
  { id: "p", name: "Google Workspace Business Plus", msrp: 0, wholesale: 0, margin_pct: null, is_active: true, prices: {} },
];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const hero = () => document.querySelector("[data-testid=hero]") as HTMLElement;
const show = () => render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={null} />);

describe("R-2018 dark hero, white text straight on the video", () => {
  it("no light panel behind the hero text", () => {
    show();
    const text = screen.getByTestId("hero-text");
    expect(text.className).not.toMatch(/bg-paper|bg-white|backdrop-blur|rounded-2xl/);
    expect(text.className).not.toMatch(/\bp-5\b|\bsm:p-7\b/);
  });

  it("the layer is an ink gradient: 80% over the text column, 50% on the right; flat 80% below lg", () => {
    show();
    const dim = hero().querySelector("[data-testid=hero-dim]") as HTMLElement;
    const c = dim.className;
    expect(c).not.toMatch(/bg-black\/10/);
    expect(c).toMatch(/(^|\s)bg-ink\/80(\s|$)/);
    expect(c).toMatch(/lg:bg-gradient-to-r/);
    expect(c).toMatch(/lg:from-ink\/80/);
    expect(c).toMatch(/lg:via-ink\/80/);
    expect(c).toMatch(/lg:via-60%/);
    expect(c).toMatch(/lg:to-ink\/50/);
  });

  it("text colours are for a dark background", () => {
    show();
    const text = screen.getByTestId("hero-text");
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.className).toMatch(/\btext-white\b/);
    expect(h1.querySelector(".text-orange-300")?.textContent).toMatch(/Ready before your chai gets/);
    expect(text.querySelector("p.text-white\\/85")?.textContent).toMatch(/Professional email on your own domain/);
    expect(text.outerHTML).not.toMatch(/text-ink(-2|-3)?\b/);
    expect(text.outerHTML).not.toMatch(/border-hairline/);
    const ticks = Array.from(text.querySelectorAll("li > span[aria-hidden]"));
    expect(ticks.length).toBe(4);
    ticks.forEach((t) => expect(t.className).toMatch(/text-emerald-300/));
    expect(within(text).getByText("EVERY PLAN INCLUDES").className).toMatch(/text-white\/70/);
    const pill = within(text).getByText(/reseller since 2014/);
    expect(pill.className).toMatch(/bg-ink\/40/);
    expect(pill.className).toMatch(/text-white/);
    // the app tiles stay white
    expect(text.querySelectorAll("li span.bg-white").length).toBe(5);
  });

  it("'Workspace' in the wordmark is white on the dark hero; the light version elsewhere is unchanged", () => {
    show();
    const h1 = screen.getByRole("heading", { level: 1 });
    const ws = Array.from(h1.querySelectorAll("span")).find((s) => s.textContent === "Workspace") as HTMLElement;
    expect(ws.style.color).toBe("rgb(255, 255, 255)");
    cleanup();
    render(<GoogleWorkspaceWordmark />);
    expect(screen.getByText("Workspace").style.color).toBe("rgb(95, 99, 104)");
  });

  it("buttons: 'See plans and prices' amber primary, the trial a white outline; visible focus rings on dark", () => {
    show();
    const plans = screen.getByRole("button", { name: "See plans and prices" });
    expect(plans.className).toMatch(/\bbg-amber\b/);
    expect(plans.className).toMatch(/\btext-white\b/);
    expect(plans.className).not.toMatch(/\bbg-ink\b/);
    const trial = screen.queryByRole("button", { name: /day free trial/ });
    if (trial) {
      expect(trial.className).toMatch(/border-white\/70/);
      expect(trial.className).toMatch(/\btext-white\b/);
      expect(trial.className).toMatch(/hover:bg-white\/10/);
    }
    for (const b of [plans, trial].filter(Boolean) as HTMLElement[]) {
      expect(b.className).toMatch(/focus-visible:ring-white/);
      expect(b.className).toMatch(/focus-visible:ring-offset-ink/);
    }
  });

  it("the price card stays a white card with a slightly stronger shadow", () => {
    show();
    const card = screen.getByRole("heading", { level: 2, name: "Your price" }).closest("div.bg-white") as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.className).toMatch(/shadow-\[0_24px_48px_-24px_rgba\(0,0,0,0\.45\)\]/);
  });

  it("AA on the worst frame (white under 80% ink): every hero text ≥ 4.5:1 (headline chai line too)", () => {
    const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const L = (p: number[]) => 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
    const hex = (h: string) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
    const over = (fg: number[], a: number, bg: number[]) => fg.map((v, i) => a * v + (1 - a) * bg[i]);
    const ratio = (a: number[], b: number[]) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const bg = over(hex("#1A1815"), 0.8, [255, 255, 255]);
    const texts: Array<[string, string, number]> = [
      ["H1 white", "#FFFFFF", 1],
      ["chai line orange-300", "#FDBA74", 1],
      ["paragraph / checks / app names white/85", "#FFFFFF", 0.85],
      ["EVERY PLAN INCLUDES white/70", "#FFFFFF", 0.7],
      ["tick emerald-300", "#6EE7B7", 1],
    ];
    for (const [, c, op] of texts) expect(ratio(over(hex(c), op, bg), bg)).toBeGreaterThanOrEqual(4.5);
    // white on the amber button
    expect(ratio([255, 255, 255], hex("#C2410C"))).toBeGreaterThanOrEqual(4.5);
  });
});
