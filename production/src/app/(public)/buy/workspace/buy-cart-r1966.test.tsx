// @vitest-environment jsdom
/**
 * R-1966 (26 Oct 2026, Pardeep on staging /buy/workspace: "ye product ka buy now page hai par buy
 * now ka option hi nahi; cart bhi show ho"). The owner's path: Starter, 10 users → Add to cart →
 * the header cart shows 1 and the drawer shows the plan and total → its Checkout opens the
 * Workspace Buy now dialog on the same plan. With online payment off (staging today) the page
 * still offers Add to cart, and the main button says what it does ("Get a GST quote").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { BuyWorkspaceClient } from "./buy-workspace-client";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  push.mockReset();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("R-1966 /buy/workspace — Buy now + Add to cart + the website cart", () => {
  it("Starter, 10 users → Add to cart → header shows 1, drawer shows plan + total, Checkout opens the Buy now dialog", async () => {
    render(<BuyWorkspaceClient paymentMode="simulation" initialTierId="starter" initialSeats={10} />);
    expect(screen.getByTestId("header-cart-count").textContent).toBe("0");

    const hero = screen.getByTestId("hero-actions");
    const buttons = within(hero).getAllByRole("button");
    // Buy now is the FIRST (main) action; Add to cart beside it.
    expect(buttons[0].textContent).toMatch(/Buy now/);
    fireEvent.click(within(hero).getByRole("button", { name: /Add to cart/ }));

    expect((await screen.findByTestId("header-cart-count")).textContent).toBe("1");
    const drawer = await screen.findByRole("dialog", { name: "Cart" });
    expect(within(drawer).getAllByText(/Google Workspace .*Starter/).length).toBeGreaterThan(0);
    expect(within(drawer).getByText("10 users · 1-year plan, billed annually")).toBeTruthy();
    // 10 × ₹270 × 12 = ₹32,400 + 18% GST = ₹38,232 — the buy page's own sum.
    const pay = within(drawer).getByRole("button", { name: /Checkout · ₹38,232/ });
    fireEvent.click(pay);
    expect(push).toHaveBeenCalledWith("/buy/workspace?tier=starter&seats=10&buy=1");
  });

  it("Add to cart twice keeps ONE Workspace line (the latest choice), not two orders", async () => {
    render(<BuyWorkspaceClient paymentMode="simulation" initialTierId="starter" initialSeats={10} />);
    const hero = screen.getByTestId("hero-actions");
    fireEvent.click(within(hero).getByRole("button", { name: /Add to cart/ }));
    fireEvent.click(within(hero).getByRole("button", { name: /Add to cart/ }));
    expect((await screen.findByTestId("header-cart-count")).textContent).toBe("1");
  });

  it("header: cart link + Buy now (no anchor-only 'Get started')", () => {
    render(<BuyWorkspaceClient paymentMode="live" initialTierId="standard" />);
    const header = document.querySelector("header") as HTMLElement;
    expect(within(header).getByRole("link", { name: /Cart, 0 items/ }).getAttribute("href")).toBe("/cart");
    expect(within(header).getByRole("button", { name: "Buy now" })).toBeTruthy();
    expect(within(header).queryByText("Get started")).toBeNull();
  });

  it("payment off (staging/production before go-live): Add to cart still there; main button is honest", async () => {
    render(<BuyWorkspaceClient paymentMode="disabled" initialTierId="starter" initialSeats={10} />);
    const hero = screen.getByTestId("hero-actions");
    expect(within(hero).getAllByRole("button")[0].textContent).toMatch(/Get a GST quote/);
    expect(within(hero).queryByText(/Buy now/)).toBeNull();
    fireEvent.click(within(hero).getByRole("button", { name: /Add to cart/ }));
    expect((await screen.findByTestId("header-cart-count")).textContent).toBe("1");
    // The pricing cards offer Add to cart too.
    expect(screen.getAllByRole("button", { name: /Add to cart/ }).length).toBeGreaterThan(1);
  });

  it("payment off + arriving from the cart's Checkout (?buy=1) → the quote form says online payment opens soon", async () => {
    render(<BuyWorkspaceClient paymentMode="disabled" initialTierId="starter" initialSeats={10} openBuy />);
    expect((await screen.findByRole("note")).textContent).toMatch(/Online payment opens soon/);
  });

  it("the hero WhatsApp is no longer a filled green button bigger than Buy now", () => {
    render(<BuyWorkspaceClient paymentMode="live" initialTierId="starter" />);
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href*="wa.me"]:not([aria-label="Chat with us on WhatsApp"])')) {
      expect(a.style.background).not.toMatch(/37, ?211, ?102|#25D366/i);
    }
  });
});
