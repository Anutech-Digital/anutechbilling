// @vitest-environment jsdom
/**
 * R-1988 (Pardeep, 26 Oct 2026): the empty space in the priced plan cards holds a media slot.
 *   - A plan with a YouTube link (PLAN_MEDIA — Pardeep's own link, never a guessed id): a lite
 *     embed — only the thumbnail (i.ytimg.com) on load, no YouTube script, frame or request; a
 *     click loads the youtube-nocookie.com player in place. Button: "Play video: <title>".
 *   - A plan without one: three feature highlights.
 *   - CSP lets the nocookie player frame in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }));

import { BuyWorkspaceClient, type CatalogItem } from "./buy-workspace-client";
import { PLAN_MEDIA } from "./_parts/plans";
import { PlanMedia, youtubeId } from "./_parts/plan-media";

const row = (id: string, name: string, annual: number, monthly: number): CatalogItem => ({
  id, name, msrp: annual, wholesale: 0, margin_pct: null, is_active: true,
  prices: { annual: { msrp: annual, wholesale: 0 }, monthly: { msrp: monthly, wholesale: 0 } },
});
const CATALOG = [row("s", "Google Workspace Business Starter", 270, 325), row("d", "Google Workspace Business Standard", 1080, 1300),
  { id: "p", name: "Google Workspace Business Plus", msrp: 0, wholesale: 0, margin_pct: null, is_active: true, prices: {} } as CatalogItem];

let fetched: string[] = [];
beforeEach(() => {
  fetched = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { fetched.push(String(url)); return new Response("{}", { status: 200 }); }));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const card = (name: string) => within(document.getElementById("plans") as HTMLElement).getByRole("article", { name });

describe("R-1988 plan card media slot", () => {
  it("Pardeep's video (iBmcvcgXUgE) on Business Starter and Business Standard — no playlist / index", () => {
    expect(PLAN_MEDIA.starter?.youtubeId).toBe("iBmcvcgXUgE");
    expect(PLAN_MEDIA.standard?.youtubeId).toBe("iBmcvcgXUgE");
    expect(PLAN_MEDIA.plus).toBeUndefined();
    expect(PLAN_MEDIA.enterprise).toBeUndefined();
  });

  it("on load: only the thumbnail — no iframe, no YouTube script, no YouTube request", () => {
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={null} />);
    const c = card("Business Starter");
    const play = within(c).getByRole("button", { name: "Play video: Workspace feature drop" });
    expect(play.querySelector("img")?.getAttribute("src")).toBe("https://i.ytimg.com/vi/iBmcvcgXUgE/hqdefault.jpg");
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector('script[src*="youtube"]')).toBeNull();
    expect(fetched.filter((u) => /youtube|ytimg/.test(u))).toEqual([]);
  });

  it("click → the youtube-nocookie player loads in place, autoplaying", () => {
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={null} />);
    const c = card("Business Standard");
    fireEvent.click(within(c).getByRole("button", { name: "Play video: Workspace feature drop" }));
    const f = c.querySelector("iframe") as HTMLIFrameElement;
    expect(f.getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/iBmcvcgXUgE?autoplay=1&rel=0");
    expect(f.getAttribute("title")).toBe("Workspace feature drop");
    expect(within(c).queryByRole("button", { name: /^Play video/ })).toBeNull();
  });

  it("no link → three feature highlights", () => {
    render(<PlanMedia media={undefined} highlights={["Custom email @yourcompany", "30 GB per user", "Gemini in Gmail", "extra"]} />);
    const items = screen.getAllByRole("listitem").map((li) => li.lastElementChild?.textContent);
    expect(items).toEqual(["Custom email @yourcompany", "30 GB per user", "Gemini in Gmail"]);
  });

  it("a malformed id is never embedded (highlights instead)", () => {
    expect(youtubeId("iBmcvcgXUgE")).toBe("iBmcvcgXUgE");
    expect(youtubeId("https://evil.example/x")).toBeNull();
    render(<PlanMedia media={{ youtubeId: "bad id!", title: "x" }} highlights={["a", "b", "c"]} />);
    expect(screen.queryByRole("button", { name: /Play video/ })).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("Plus and Enterprise (quoted) get no media slot", () => {
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={null} />);
    expect(within(card("Business Plus")).queryByTestId("plan-media")).toBeNull();
    expect(within(card("Enterprise")).queryByTestId("plan-media")).toBeNull();
  });

  it("plan cards still have 8 rows each (buttons stay aligned)", () => {
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={null} />);
    for (const c of within(document.getElementById("plans") as HTMLElement).getAllByRole("article")) {
      expect([...c.children].filter((el) => !el.className.includes("absolute"))).toHaveLength(8);
    }
  });
});
