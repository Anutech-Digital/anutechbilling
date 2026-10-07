/**
 * R-225 (7 Oct 2026): the cart page told every visitor the coupon codes ("Have a code?
 * ANUTECH10 or MIGRATE15."). Pardeep: keep the coupons, but no code name may appear in the
 * page — not in the hint, not in the error, not as the input's placeholder.
 * R-329: the page no longer knows the codes at all — the cart provider asks the server, and
 * the page renders the answer (couponStatus). A valid code says it is for the first payment.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cartTotals, type CartLine } from "@/site/lib/money";
import type { CouponStatus } from "@/site/components/cart/CartProvider";

const CODES = ["ANUTECH10", "MIGRATE15"];
const state: { lines: CartLine[]; coupon: string; status: CouponStatus; rate: number } = { lines: [], coupon: "", status: "empty", rate: 0 };

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/site/components/ui/SiteLink", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/site/components/cart/DomainYears", () => ({ DomainYears: () => null }));
vi.mock("@/site/components/cart/CartProvider", () => ({
  useCart: () => ({
    lines: state.lines,
    coupon: state.coupon,
    couponStatus: state.status,
    setCoupon: () => {},
    setQty: () => {},
    remove: () => {},
    totals: cartTotals(state.lines, state.status === "valid" ? state.rate : 0),
  }),
}));

import CartPage from "./page";

const hosting: CartLine = { key: "h", label: "Standard hosting", detail: "", unitPrice: 2999, qty: 1, unit: "year", cycle: "yearly", sku: "hosting:standard" };
const domain: CartLine = { key: "d", label: "acme.in", detail: "", unitPrice: 799, qty: 1, unit: "year", cycle: "yearly", sku: "domain:in", domain: "acme.in" };

function render(lines: CartLine[], coupon: string, status: CouponStatus, rate = 0): string {
  Object.assign(state, { lines, coupon, status, rate });
  return renderToStaticMarkup(<CartPage />);
}

describe("cart page never names a coupon code (R-225)", () => {
  it.each([["", "empty"], ["BOGUS50", "invalid"], ["ANUTECH", "checking"]] as const)("coupon box %j (%s) — no code in the HTML", (typed, status) => {
    const out = render([hosting], typed, status).toUpperCase();
    for (const c of CODES) expect(out).not.toContain(c);
    if (!typed) expect(out).toContain("HAVE A COUPON CODE?");
  });

  it("an unknown code is refused without suggesting one", () => {
    const out = render([hosting], "BOGUS50", "invalid").toUpperCase();
    expect(out).toContain("THAT CODE IS NOT VALID.");
    for (const c of CODES) expect(out).not.toContain(c);
  });

  it("while the server is asked, no discount is shown yet", () => {
    const out = render([hosting], "ANUTECH10", "checking");
    expect(out).toContain("Checking the code");
    expect(out).not.toContain("% off");
  });
});

describe("a valid code (R-225, R-329)", () => {
  it("on a domain-only cart: says coupons do not apply to domains, and takes nothing off", () => {
    const out = render([domain], "anutech10", "valid", 0.1);
    expect(out).toContain("Coupons don&#x27;t apply to domain names.");
    expect(out).not.toContain("% off");
  });

  it("on hosting + domain: hosting discounted, and the page says renewals are at the regular price", () => {
    const out = render([hosting, domain], "anutech10", "valid", 0.1);
    expect(out).toContain("10% off");
    expect(out).toContain("−₹300");
    expect(out).toContain("Applied to your first payment. Renewals are at the regular price.");
  });

  it("the check could not be made: no discount shown, and the page says so", () => {
    const out = render([hosting], "ANUTECH10", "error");
    expect(out).not.toContain("% off");
    expect(out).toContain("Could not check the code");
  });
});
