/**
 * R-1630 — Workspace buy: changing seats or plan silently dropped an applied coupon.
 * The total lost its discount with no word. Now the code is checked again for the new basket:
 * still valid → it stays (with the new discount); not valid → it is removed and the buyer is
 * told why. Never calls the real server — fetch is a mock.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkCoupon, recheckCoupon, type AppliedCoupon } from "./coupon-check";

const applied: AppliedCoupon = { code: "WELCOME10", discount: 1000, discount_type: "percent", discount_value: 10, description: null };
const req = { code: "WELCOME10", tier: "starter", seats: 6, gross_amount: 12000 };

const fetchReturning = (json: unknown) => vi.fn(async () => ({ json: async () => json }) as unknown as Response);

describe("checkCoupon", () => {
  it("posts the basket to the validate endpoint and returns the coupon", async () => {
    const f = fetchReturning({ ok: true, code: "WELCOME10", discount: 1200, discount_type: "percent", discount_value: 10, description: null });
    const r = await checkCoupon(req, f as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, coupon: { ...applied, discount: 1200 } });
    expect(f).toHaveBeenCalledWith("/api/public/coupons/validate", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual(req);
  });

  it("explains a refusal in words", async () => {
    const r = await checkCoupon(req, fetchReturning({ ok: false, reason: "max_seats_exceeded", max_seats: 5 }) as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, message: "Code only works up to 5 seats" });
  });
});

describe("recheckCoupon — after seats or plan change", () => {
  it("still valid: keeps the code with the new discount, no error", async () => {
    const f = fetchReturning({ ok: true, code: "WELCOME10", discount: 1200, discount_type: "percent", discount_value: 10, description: null });
    expect(await recheckCoupon(applied, req, f as unknown as typeof fetch)).toEqual({
      applied: { ...applied, discount: 1200 }, error: null,
    });
  });

  it("no longer valid: removes it and says why", async () => {
    const f = fetchReturning({ ok: false, reason: "max_seats_exceeded", max_seats: 5 });
    expect(await recheckCoupon(applied, req, f as unknown as typeof fetch)).toEqual({
      applied: null, error: "Coupon WELCOME10 removed — Code only works up to 5 seats",
    });
  });

  it("network failure: removes it and asks to apply again", async () => {
    const f = vi.fn(async () => { throw new Error("offline"); });
    const r = await recheckCoupon(applied, req, f as unknown as typeof fetch);
    expect(r.applied).toBeNull();
    expect(r.error).toMatch(/WELCOME10.*apply it again/);
  });
});

describe("the checkout re-checks instead of clearing silently", () => {
  /* R-1971: the coupon box lives in the inline checkout's state (_parts/use-checkout.ts). */
  const src = readFileSync(resolve(__dirname, "_parts", "use-checkout.ts"), "utf8");
  it("the tier/seats effect calls recheckCoupon", () => {
    expect(src).toMatch(/recheckCoupon\(/);
    expect(src).not.toMatch(/When tier or seats change, clear any applied coupon/);
  });
});
