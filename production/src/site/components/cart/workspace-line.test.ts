// @vitest-environment jsdom
/**
 * R-1966: Google Workspace in the website cart. The line shows the SAME annual sum the buy
 * page and the Workspace checkout charge (annualTotals, R-276) — the cart never invents a
 * price — and its Checkout always goes to the Workspace Buy now dialog, which is where a
 * Workspace order is priced on the server.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { cartTotals, type CartLine } from "@/site/lib/money";
import { annualTotals } from "@/app/(public)/buy/workspace/tier-price";
import {
  CART_STORAGE_KEY, cartCheckoutHref, dropWorkspaceLinesFromStoredCart, isWorkspaceLine,
  workspaceBuyHref, workspaceCartLine,
} from "./workspace-line";

const asLine = (l: Omit<CartLine, "key">, key = "k1"): CartLine => ({ ...l, key });

describe("R-1966 workspaceCartLine", () => {
  it("Starter, 10 users at ₹270/user/month → 10 × ₹3,240 a year; totals equal the buy page's annual sum", () => {
    const l = workspaceCartLine({ tierId: "starter", tierName: "Business Starter", seats: 10, ratePerUserMonth: 270 });
    expect(l).toMatchObject({
      label: "Google Workspace Business Starter", qty: 10, unitPrice: 3240, cycle: "yearly", sku: "workspace:starter",
    });
    expect(l.detail).toBe("10 users · 1-year plan, billed annually");
    const t = cartTotals([asLine(l)], 0);
    const page = annualTotals(10, 270); // ₹32,400 + ₹5,832 GST = ₹38,232
    expect(t.subtotal).toBe(page.annual);
    expect(t.gst).toBe(page.gst);
    expect(t.payable).toBe(page.total);
    expect(t.payable).toBe(38232);
    expect(t.recurring).toBe(0);
  });

  it("users are clamped to 1..300 like the online buy link", () => {
    expect(workspaceCartLine({ tierId: "standard", tierName: "S", seats: 0, ratePerUserMonth: 1080 }).qty).toBe(1);
    expect(workspaceCartLine({ tierId: "standard", tierName: "S", seats: 999, ratePerUserMonth: 1080 }).qty).toBe(300);
  });
});

describe("R-1966 where the cart's Checkout goes", () => {
  it("a Workspace line → its Buy now dialog, prefilled with edition + users", () => {
    const ws = asLine(workspaceCartLine({ tierId: "standard", tierName: "Business Standard", seats: 12, ratePerUserMonth: 1080 }));
    expect(isWorkspaceLine(ws)).toBe(true);
    expect(workspaceBuyHref(ws)).toBe("/buy/workspace?tier=standard&seats=12&buy=1");
    expect(cartCheckoutHref([ws])).toBe("/buy/workspace?tier=standard&seats=12&buy=1");
  });

  it("users changed in the drawer go with it", () => {
    const ws = { ...asLine(workspaceCartLine({ tierId: "starter", tierName: "S", seats: 10, ratePerUserMonth: 270 })), qty: 14 };
    expect(cartCheckoutHref([ws])).toBe("/buy/workspace?tier=starter&seats=14&buy=1");
  });

  it("a mixed cart pays Workspace first; a cart without Workspace keeps /checkout", () => {
    const host: CartLine = { key: "h", label: "Starter hosting", detail: "", unitPrice: 1999, qty: 1, unit: "year", cycle: "yearly", sku: "hosting:starter" };
    const ws = asLine(workspaceCartLine({ tierId: "starter", tierName: "S", seats: 3, ratePerUserMonth: 270 }), "w");
    expect(cartCheckoutHref([host, ws])).toBe("/buy/workspace?tier=starter&seats=3&buy=1");
    expect(cartCheckoutHref([host])).toBe("/checkout");
    expect(cartCheckoutHref([])).toBe("/checkout");
  });

  it("an edition not sold online never gets a pay link", () => {
    expect(workspaceBuyHref({ sku: "workspace:enterprise", qty: 5 })).toBeNull();
  });
});

describe("R-1966 the paid Workspace line leaves the stored cart", () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 };
    Object.defineProperty(window, "localStorage", { value: store, configurable: true });
  });
  it("drops only Workspace lines", () => {
    const host = { key: "h", label: "Hosting", sku: "hosting:starter", unitPrice: 1, qty: 1 };
    const ws = { key: "w", label: "GW", sku: "workspace:starter", unitPrice: 1, qty: 1 };
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([host, ws]));
    dropWorkspaceLinesFromStoredCart();
    expect(JSON.parse(window.localStorage.getItem(CART_STORAGE_KEY) ?? "[]")).toEqual([host]);
  });
  it("no cart or a broken one → no throw", () => {
    expect(() => dropWorkspaceLinesFromStoredCart()).not.toThrow();
    window.localStorage.setItem(CART_STORAGE_KEY, "{oops");
    expect(() => dropWorkspaceLinesFromStoredCart()).not.toThrow();
  });
});
