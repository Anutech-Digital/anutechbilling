// @vitest-environment jsdom
/**
 * R-1797 — a cart saved before a price change is re-priced from GET /api/public/catalog when
 * the cart page or checkout opens; the notice says what changed. Flag off ("code") → untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";

const route = vi.hoisted(() => ({ path: "/cart" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.path }));

import { CartProvider, useCart } from "./CartProvider";
import { PriceChangeNotice } from "./PriceChangeNotice";

const SAVED = [
  { key: "h1", label: "Starter hosting", detail: "x", unitPrice: 600, qty: 1, unit: "year", cycle: "yearly", sku: "hosting:starter" },
  { key: "m1", label: "Mailbox", detail: "Anutech Mail · billed yearly", unitPrice: 948, qty: 2, unit: "year", cycle: "yearly", sku: "mailbox:anutech" },
];

function Probe() {
  const cart = useCart();
  return (
    <div>
      <PriceChangeNotice changes={cart.priceChanges} />
      <span data-testid="payable">{Math.round(cart.totals.payable)}</span>
    </div>
  );
}

function catalog(source: "code" | "catalog", starterYr: number) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ gstRate: 18, source, items: [{ sku: "HOST-STARTER-YR", exGst: starterYr }, { sku: "HOST-STARTER-MO", exGst: 100 }, { sku: "MAIL-ANUTECH-YR", exGst: 948 }] }), { status: 200 }),
  );
}

/* A plain in-memory storage: this jsdom setup has no window.localStorage of its own. */
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
  route.path = "/cart";
  Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
  window.localStorage.setItem("anutech.cart.v1", JSON.stringify(SAVED));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CartProvider re-prices a saved cart (R-1797)", () => {
  it("flag on, Starter now ₹610: the total moves to what the server charges, and the notice says so", async () => {
    const fetchMock = catalog("catalog", 610);
    vi.stubGlobal("fetch", fetchMock);
    render(<CartProvider><Probe /></CartProvider>);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Price changed: Starter hosting ₹600 → ₹610. The total below is what you will pay."));
    // Starter yearly makes one mailbox free (R-1595): 610 + 948 = 1558 → ₹1,838 with GST.
    expect(screen.getByTestId("payable").textContent).toBe(String(Math.round((610 + 948) * 1.18)));
    expect(fetchMock).toHaveBeenCalledWith("/api/public/catalog", expect.anything());
    expect(JSON.parse(window.localStorage.getItem("anutech.cart.v1")!)[0].unitPrice).toBe(610);
  });

  it("flag off (source code): the cart is left as it is and no notice shows", async () => {
    const fetchMock = catalog("code", 610);
    vi.stubGlobal("fetch", fetchMock);
    render(<CartProvider><Probe /></CartProvider>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("payable").textContent).toBe(String(Math.round((600 + 948) * 1.18)));
  });

  it("other pages do not read the catalogue", async () => {
    route.path = "/hosting";
    const fetchMock = catalog("catalog", 610);
    vi.stubGlobal("fetch", fetchMock);
    render(<CartProvider><Probe /></CartProvider>);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
