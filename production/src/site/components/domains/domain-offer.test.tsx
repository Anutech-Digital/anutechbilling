// @vitest-environment jsdom
//
// R-1772 (22 Oct 2026, found on localhost while checking R-1769 with its TEST prices):
// /domains → "mytestshop" → mytestshop.in ₹649 → "Domain only" showed "₹1,884 total incl.
// 18% GST" next to "Add the name only", while the cart and checkout charged ₹766 (₹649 + ₹117
// GST). The page's own sum still counted the ₹948 mailbox that only the hosting choice adds.
// And the Domain + Hosting card then said "You're on monthly billing" although Yearly was on.
// The shown total and the cart now come from ONE helper (domainOffer → cartTotals).
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

const added: unknown[] = [];
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/fonts", () => ({
  domainSans: { variable: "df-sans" },
  domainSerif: { variable: "df-serif" },
  domainMono: { variable: "df-mono" },
}));
vi.mock("@/site/components/cart/CartProvider", () => ({
  useCart: () => ({ lines: [], add: (l: unknown) => added.push(l), remove: vi.fn(), closeDrawer: vi.fn() }),
}));

import { DomainLanding } from "./DomainLanding";
import { domainOffer } from "./domain-offer";
import { cartTotals, rupee, type CartLine } from "@/site/lib/money";
import { HOSTING_TIERS } from "@/site/lib/data/hosting-landing-v2";

const standard = HOSTING_TIERS.find((t) => t.name === "Standard")!;

/** What the cart drawer shows as "payable" for the lines the page added. */
function cartPayable(lines: unknown[]): string {
  const cart = (lines as Omit<CartLine, "key" | "qty">[]).map((l, i) => ({ ...l, key: `k${i}`, qty: 1 }));
  return rupee(cartTotals(cart, 0).payable);
}

beforeEach(() => {
  added.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    base: "mytestshop",
    domains: [{ domain: "mytestshop.in", available: true, price: 649, currency: "INR", years: 1, priceKnown: true, prices: { "1": 649 }, testPrice: true }],
  }), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function searchMyTestShop() {
  render(<DomainLanding tlds={[]} />);
  fireEvent.change(screen.getByLabelText("Domain name to search"), { target: { value: "mytestshop" } });
  fireEvent.submit(screen.getByLabelText("Domain name to search").closest("form")!);
  await screen.findByText("Pick one — you can change it any time before you pay.");
}
const shownTotal = () => screen.getByText("total incl. 18% GST").previousElementSibling!.textContent;
const bundleCard = () => screen.getByRole("radio", { name: /Domain \+ hosting/i });

describe("/domains result — the shown total is the cart's total (R-1772)", () => {
  it("Domain only: ₹649 name → ₹766 next to 'Add the name only', and the cart is ₹766", async () => {
    await searchMyTestShop();
    fireEvent.click(screen.getByRole("radio", { name: /Domain only/i }));
    expect(shownTotal()).toBe("₹766");
    fireEvent.click(screen.getByRole("button", { name: "Add the name only →" }));
    expect(added).toHaveLength(1);
    expect(cartPayable(added)).toBe("₹766");
  });

  it("Domain + Hosting, Yearly, Standard: the name is ₹0 and the shown total is the cart's total", async () => {
    await searchMyTestShop();
    expect(within(bundleCard()).getByText("₹0")).toBeTruthy();
    const expected = rupee(Math.round(standard.yearlyTotal) * 1.18); // mailbox free with the yearly plan
    expect(shownTotal()).toBe(expected);
    fireEvent.click(screen.getByRole("button", { name: "Add to cart →" }));
    expect(cartPayable(added)).toBe(expected);
  });

  it("Domain only and back keeps Yearly — no 'monthly billing' line, the name is ₹0 again", async () => {
    await searchMyTestShop();
    fireEvent.click(screen.getByRole("radio", { name: /Domain only/i }));
    expect(screen.queryByText(/on monthly billing/)).toBeNull();
    expect(within(bundleCard()).getByText("₹0")).toBeTruthy();
    fireEvent.click(bundleCard());
    expect(screen.getByRole("button", { name: /^Yearly/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText(/on monthly billing/)).toBeNull();
    expect(within(bundleCard()).getByText("₹0")).toBeTruthy();
  });

  it("Monthly still says the free domain needs a yearly plan", async () => {
    await searchMyTestShop();
    fireEvent.click(screen.getByRole("button", { name: "Monthly" }));
    expect(screen.getByText(/on monthly billing/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to cart →" }));
    expect(cartPayable(added)).toBe(shownTotal());
  });
});

describe("domainOffer — one helper for the cart lines and the total", () => {
  const base = { domain: "mytestshop.in", tld: ".in", domainReg: 649, domainRenew: null, yearPrices: { "1": 649 }, testPrice: false, tier: standard, yearly: true, mailOn: true };

  it("domain only → one domain line, ₹766, nothing saved", () => {
    const o = domainOffer({ ...base, hostingOn: false });
    expect(o.lines.map((l) => l.sku)).toEqual(["domain:in"]);
    expect(o.total).toBe(766);
    expect(o.saved).toBe(0);
  });

  it("domain + yearly Standard + mailbox → domain and mailbox free", () => {
    const o = domainOffer({ ...base, hostingOn: true });
    expect(o.lines.map((l) => l.sku)).toEqual(["domain:in", "hosting:standard", "mailbox:anutech"]);
    expect(o.domainFree).toBe(true);
    expect(o.total).toBe(Math.round(Math.round(standard.yearlyTotal) * 1.18));
    expect(o.saved).toBe(649 + 948);
  });

  it("every line carries a sku; the domain line carries its name", () => {
    for (const l of domainOffer({ ...base, hostingOn: true }).lines) expect(l.sku).toBeTruthy();
    expect(domainOffer({ ...base, hostingOn: false }).lines[0].domain).toBe("mytestshop.in");
  });

  it("no live price → no lines, no total", () => {
    const o = domainOffer({ ...base, domainReg: null, hostingOn: false });
    expect(o.lines).toEqual([]);
    expect(o.total).toBeNull();
  });
});
