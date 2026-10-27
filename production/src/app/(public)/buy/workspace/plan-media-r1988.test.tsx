// @vitest-environment jsdom
/**
 * R-1988 (Pardeep, 26 Oct 2026): the empty space in the priced plan cards holds a media slot.
 * R-2031 (Pardeep, 27 Oct 2026, "this image goes in place of 1"): the slot on Business Starter and
 * Business Standard is Pardeep's "Google Workspace + apps" image (public/buy/workspace-apps.webp) —
 * no YouTube video, no YouTube thumbnail, no iframe. Same 16:9 slot, so cards and buttons stay aligned.
 *   - A plan without media: three feature highlights.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }));

import { BuyWorkspaceClient, type CatalogItem } from "./buy-workspace-client";
import { PLAN_MEDIA } from "./_parts/plans";
import { PlanMedia } from "./_parts/plan-media";

const row = (id: string, name: string, annual: number, monthly: number): CatalogItem => ({
  id, name, msrp: annual, wholesale: 0, margin_pct: null, is_active: true,
  prices: { annual: { msrp: annual, wholesale: 0 }, monthly: { msrp: monthly, wholesale: 0 } },
});
const CATALOG = [row("s", "Google Workspace Business Starter", 270, 325), row("d", "Google Workspace Business Standard", 1080, 1300),
  { id: "p", name: "Google Workspace Business Plus", msrp: 0, wholesale: 0, margin_pct: null, is_active: true, prices: {} } as CatalogItem];

const ALT = "Google Workspace apps: Gmail, Drive, Docs, Sheets, Slides, Meet, Calendar";

let fetched: string[] = [];
beforeEach(() => {
  fetched = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { fetched.push(String(url)); return new Response("{}", { status: 200 }); }));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const card = (name: string) => within(document.getElementById("plans") as HTMLElement).getByRole("article", { name });

describe("R-2031 plan card media slot: Pardeep's Workspace apps image", () => {
  it("Business Starter and Standard use /buy/workspace-apps.webp; Plus / Enterprise none", () => {
    expect(PLAN_MEDIA.starter?.src).toBe("/buy/workspace-apps.webp");
    expect(PLAN_MEDIA.standard?.src).toBe("/buy/workspace-apps.webp");
    expect(PLAN_MEDIA.plus).toBeUndefined();
    expect(PLAN_MEDIA.enterprise).toBeUndefined();
  });

  it("the image file is in public/ (served at /buy/workspace-apps.webp)", () => {
    const f = path.join(process.cwd(), "public", "buy", "workspace-apps.webp");
    expect(fs.existsSync(f)).toBe(true);
    expect(fs.readFileSync(f).subarray(8, 12).toString()).toBe("WEBP");
  });

  it("on the card: the image — fixed width/height, lazy, the apps alt text; no video, no YouTube", () => {
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={null} />);
    for (const name of ["Business Starter", "Business Standard"]) {
      const img = within(card(name)).getByRole("img", { name: ALT });
      expect(img.getAttribute("src")).toBe("/buy/workspace-apps.webp");
      expect(img.getAttribute("width")).toBe("1536");
      expect(img.getAttribute("height")).toBe("1024");
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(within(card(name)).queryByRole("button", { name: /Play video/ })).toBeNull();
    }
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector('img[src*="ytimg"], script[src*="youtube"]')).toBeNull();
    expect(fetched.filter((u) => /youtube|ytimg/.test(u))).toEqual([]);
  });

  it("the slot keeps the old 16:9 size, so the cards and buttons stay aligned", () => {
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={null} />);
    const slot = within(card("Business Starter")).getByTestId("plan-media");
    expect(slot.className).toMatch(/\baspect-video\b/);
    expect(slot.className).toMatch(/\bw-full\b/);
  });

  it("no media → three feature highlights", () => {
    render(<PlanMedia media={undefined} highlights={["Custom email @yourcompany", "30 GB per user", "Gemini in Gmail", "extra"]} />);
    const items = screen.getAllByRole("listitem").map((li) => li.lastElementChild?.textContent);
    expect(items).toEqual(["Custom email @yourcompany", "30 GB per user", "Gemini in Gmail"]);
  });

  it("Plus and Enterprise (quoted) get no media slot", () => {
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={null} />);
    expect(within(card("Business Plus")).queryByTestId("plan-media")).toBeNull();
    expect(within(card("Enterprise")).queryByTestId("plan-media")).toBeNull();
  });

  it("plan cards still have 7 rows each (buttons stay aligned; R-2030 merged the price row into the box)", () => {
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={null} />);
    for (const c of within(document.getElementById("plans") as HTMLElement).getAllByRole("article")) {
      expect([...c.children].filter((el) => !el.className.includes("absolute"))).toHaveLength(7);
    }
  });
});
