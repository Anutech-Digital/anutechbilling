/**
 * R-225 (7 Oct 2026): the cart page told every visitor the coupon codes ("Have a code?
 * ANUTECH10 or MIGRATE15."). Pardeep: keep the coupons, but no code name may appear in the
 * page — not in the hint, not in the error, not as the input's placeholder.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { COUPONS, cartTotals, type CartLine } from "@/site/lib/money";

const state: { lines: CartLine[]; coupon: string } = { lines: [], coupon: "" };

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/site/components/ui/SiteLink", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/site/components/cart/DomainYears", () => ({ DomainYears: () => null }));
vi.mock("@/site/components/cart/CartProvider", () => ({
  useCart: () => ({
    lines: state.lines,
    coupon: state.coupon,
    setCoupon: () => {},
    setQty: () => {},
    remove: () => {},
    totals: cartTotals(state.lines, state.coupon),
  }),
}));

import CartPage from "./page";

const hosting: CartLine = { key: "h", label: "Standard hosting", detail: "", unitPrice: 2999, qty: 1, unit: "year", cycle: "yearly", sku: "hosting:standard" };

function html(coupon: string): string {
  state.lines = [hosting];
  state.coupon = coupon;
  return renderToStaticMarkup(<CartPage />).toUpperCase();
}

describe("cart page never names a coupon code (R-225)", () => {
  const codes = Object.keys(COUPONS);

  it.each(["", "BOGUS50", "ANUTECH"])("coupon box %j — no code in the HTML", (typed) => {
    const out = html(typed);
    for (const c of codes) expect(out).not.toContain(c);
    if (!typed) expect(out).toContain("HAVE A COUPON CODE?");
  });

  it("an unknown code is refused without suggesting one", () => {
    const out = html("BOGUS50");
    expect(out).toContain("THAT CODE IS NOT VALID.");
    for (const c of codes) expect(out).not.toContain(c);
  });
});

describe("a valid code on a domain-only cart (R-225)", () => {
  it("says coupons do not apply to domains, and takes nothing off", () => {
    state.lines = [{ key: "d", label: "acme.in", detail: "", unitPrice: 799, qty: 1, unit: "year", cycle: "yearly", sku: "domain:in", domain: "acme.in" }];
    state.coupon = "anutech10";
    const out = renderToStaticMarkup(<CartPage />);
    expect(out).toContain("Coupons don&#x27;t apply to domain names.");
    expect(out).not.toContain("% off");
  });
});
