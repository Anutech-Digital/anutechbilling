// @vitest-environment jsdom
/**
 * R-1114 (23 Oct 2026) — a typed coupon survives a reload (it lived only in useState, so a
 * refresh of /cart or /checkout dropped the discount), and is checked with the server again.
 * Emptying the cart (after an order) forgets it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, waitFor, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/somewhere" }));

import { CartProvider, useCart } from "./CartProvider";

let api: ReturnType<typeof useCart> | null = null;
function Probe() {
  const cart = useCart();
  api = cart;
  return <span data-testid="state">{`${cart.coupon}|${cart.couponStatus}`}</span>;
}

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
  window.localStorage.setItem("anutech.cart.v1", JSON.stringify([{ key: "s", label: "SSL", detail: "", unitPrice: 899, qty: 1, unit: "year", cycle: "yearly" }]));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ valid: true, ratePct: 10 }), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  api = null;
});

describe("R-1114 the coupon survives a reload", () => {
  it("typed code is saved; a fresh mount (reload) has it and re-checks it with the server", async () => {
    const first = render(<CartProvider><Probe /></CartProvider>);
    await waitFor(() => expect(api?.loaded).toBe(true));
    act(() => api!.setCoupon("SAVE10"));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("SAVE10|valid"));
    first.unmount();

    (fetch as unknown as ReturnType<typeof vi.fn>).mockClear();
    render(<CartProvider><Probe /></CartProvider>);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("SAVE10|valid"));
    expect(fetch).toHaveBeenCalledWith("/api/public/cart-coupon", expect.objectContaining({ method: "POST" }));
  });

  it("clearing the cart forgets the code", async () => {
    render(<CartProvider><Probe /></CartProvider>);
    await waitFor(() => expect(api?.loaded).toBe(true));
    act(() => api!.setCoupon("SAVE10"));
    act(() => api!.clear());
    cleanup();
    render(<CartProvider><Probe /></CartProvider>);
    await waitFor(() => expect(api?.loaded).toBe(true));
    expect(screen.getByTestId("state").textContent).toBe("|empty");
  });
});
