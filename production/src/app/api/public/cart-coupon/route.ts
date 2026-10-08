/**
 * POST /api/public/cart-coupon — is this cart coupon code valid? (R-329, 7 Oct 2026)
 *
 * The cart page used to check codes against a table bundled into its own JavaScript, so
 * every code was readable in the browser. Now the table is server-only
 * (lib/checkout/coupons) and the cart sends only what the visitor typed.
 *
 * Body: { code }   →   { valid: true, ratePct: 10 } | { valid: false }
 * Never lists or hints at another code. Limited per IP so codes cannot be guessed in bulk.
 * Not to be confused with /api/public/coupons/validate (the Workspace buy page's DB coupons).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { couponRate } from "@/lib/checkout/coupons";
import { rateLimit, clientIp } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const schema = z.object({ code: z.string().max(40) });

/** A person types a code a few times; 30 tries in 10 minutes is plenty, and stops a guesser. */
const CART_COUPON_LIMIT = { limit: 30, windowMs: 10 * 60_000 } as const;

export async function POST(request: NextRequest) {
  const rl = rateLimit(`cart-coupon:ip:${clientIp(request.headers)}`, CART_COUPON_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { valid: false, error: "Too many tries. Please wait a few minutes." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ valid: false }, { status: 400 });

  const rate = couponRate(parsed.data.code);
  return NextResponse.json(rate > 0 ? { valid: true, ratePct: Math.round(rate * 100) } : { valid: false });
}
