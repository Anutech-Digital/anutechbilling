/**
 * R-329 (7 Oct 2026): the cart checks a coupon code on the server, so the code table is not
 * in the browser bundle. The answer is valid + percent, or just "not valid" — never a hint.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { resetRateLimiter } from "@/lib/security/rate-limit";
import { COUPONS } from "@/lib/checkout/coupons";
import { POST } from "./route";

const req = (body: unknown, ip = "203.0.113.7") =>
  new NextRequest("https://example.invalid/api/public/cart-coupon", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });

beforeEach(() => resetRateLimiter());

describe("POST /api/public/cart-coupon (R-329)", () => {
  it("a valid code (case and spaces forgiven) → valid + its percent", async () => {
    const res = await POST(req({ code: " anutech10 " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true, ratePct: 10 });
  });

  it("an unknown code → not valid, and the reply names no code", async () => {
    const res = await POST(req({ code: "BOGUS50" }));
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ valid: false });
    for (const c of Object.keys(COUPONS)) expect(text).not.toContain(c);
  });

  it("a malformed body → 400, not valid", async () => {
    const res = await POST(req({ nope: 1 }));
    expect(res.status).toBe(400);
    expect((await res.json()).valid).toBe(false);
  });

  it("guessing in bulk is stopped per IP", async () => {
    for (let i = 0; i < 30; i++) expect((await POST(req({ code: `X${i}` }))).status).toBe(200);
    const res = await POST(req({ code: "ANUTECH10" }));
    expect(res.status).toBe(429);
    expect((await res.json()).valid).toBe(false);
    // Another visitor is not affected.
    expect((await POST(req({ code: "ANUTECH10" }, "198.51.100.9"))).status).toBe(200);
  });
});
