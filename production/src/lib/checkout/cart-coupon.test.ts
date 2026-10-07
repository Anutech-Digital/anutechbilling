/**
 * R-225 (7 Oct 2026): the cart checkout took a coupon off EVERY line, domains included —
 * and a domain sells close to the registry's cost. Pardeep: keep the coupons, never on a
 * `domain:*` line; every other line exactly as before.
 */
import { describe, it, expect } from "vitest";
import { applyCartCoupon } from "./cart-coupon";

type L = { qty: number; rate: number; list_rate?: number; renewal_rate?: number; domain?: boolean };
const isDomain = (l: L) => l.domain === true;

describe("applyCartCoupon (R-225)", () => {
  it("domain-only cart + a valid code = full price, no discount on the quote", () => {
    const items: L[] = [{ qty: 1, rate: 799, domain: true }];
    const r = applyCartCoupon(items, isDomain, "ANUTECH10");
    expect(r.discountPct).toBe(0);
    expect(r.subtotal).toBe(799);
    expect(r.quoteSubtotal).toBe(799);
    expect(r.applied).toBe(false);
    expect(items[0].rate).toBe(799);
  });

  it("no domain line: exactly as before — quote-level percent off the gross", () => {
    const items: L[] = [{ qty: 1, rate: 2999 }, { qty: 2, rate: 600 }];
    const r = applyCartCoupon(items, isDomain, " anutech10 ");
    expect(r.couponCode).toBe("ANUTECH10");
    expect(r.discountPct).toBe(10);
    expect(r.quoteSubtotal).toBe(4199);
    expect(r.subtotal).toBe(Math.round(4199 * 0.9));
    expect(items.map((i) => i.rate)).toEqual([2999, 600]);
  });

  it("a ₹0 bundled domain does not change the old rule", () => {
    const items: L[] = [{ qty: 1, rate: 2999 }, { qty: 1, rate: 0, domain: true }];
    const r = applyCartCoupon(items, isDomain, "MIGRATE15");
    expect(r.discountPct).toBe(15);
    expect(r.subtotal).toBe(Math.round(2999 * 0.85));
  });

  it("hosting + paid domain: discount off the hosting line only, domain at full price", () => {
    const items: L[] = [{ qty: 1, rate: 2999 }, { qty: 1, rate: 799, domain: true }];
    const r = applyCartCoupon(items, isDomain, "ANUTECH10");
    expect(r.discountPct).toBe(0); // a quote-level % would also hit the domain
    expect(items[0]).toMatchObject({ rate: 2699, list_rate: 2999 });
    expect(items[1].rate).toBe(799);
    expect(r.quoteSubtotal).toBe(2699 + 799);
    expect(r.subtotal).toBe(2699 + 799);
    expect(r.discount).toBe(300);
    expect(r.gross).toBe(2999 + 799);
    expect(r.applied).toBe(true);
  });

  it("unknown code: nothing off", () => {
    const items: L[] = [{ qty: 1, rate: 1000 }];
    const r = applyCartCoupon(items, isDomain, "CONSTRUCTOR");
    expect(r.discountPct).toBe(0);
    expect(r.subtotal).toBe(1000);
  });

  /* R-329 (7 Oct 2026): a coupon is for the FIRST payment only. record_payment files a
     subscription's mrr from the line's charged rate, and renewals run from that mrr — so a
     discounted hosting rate discounted every renewal too. The line now says what it renews
     at (renewal_rate = list); record_payment reads it (migration 20261007050000). */
  it("hosting + paid domain: first payment discounted, renewal stays at list", () => {
    const items: L[] = [{ qty: 1, rate: 2999 }, { qty: 1, rate: 799, domain: true }];
    applyCartCoupon(items, isDomain, "ANUTECH10");
    expect(items[0]).toMatchObject({ rate: 2699, list_rate: 2999, renewal_rate: 2999 });
    expect(items[1]).toEqual({ qty: 1, rate: 799, domain: true });
  });

  it("no paid domain: lines untouched (no renewal_rate), exactly as before R-225", () => {
    const items: L[] = [{ qty: 1, rate: 2999 }, { qty: 1, rate: 0, domain: true }];
    applyCartCoupon(items, isDomain, "ANUTECH10");
    expect(items[0]).toEqual({ qty: 1, rate: 2999 });
  });
});
