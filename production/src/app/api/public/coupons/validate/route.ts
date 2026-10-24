/**
 * POST /api/public/coupons/validate
 *
 * Dry-run coupon validation — lets the public buy page check a code
 * BEFORE the visitor commits to checkout. We compute the same discount
 * the live redemption would but DON'T record a redemption or bump the
 * counter. The real redemption happens inside the checkout route
 * (which calls redeem_coupon directly).
 *
 * Body: { code, tier, seats, gross_amount }
 * Returns: { ok: true, discount, ...} | { ok: false, reason, ...hints }
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { publicDbError } from "@/app/api/public/_lib/db-error";
import { websiteTenantId, websiteTenantMissingBody } from "@/lib/website-tenant";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

/* R-1499: the website tenant is read per request (websiteTenantId) — outside production an unset
   BUY_PAGE_TENANT_ID refuses with a clear message, never the live tenant. */

const schema = z.object({
  code:         z.string().min(2).max(50),
  tier:         z.string().min(2).max(20),
  seats:        z.coerce.number().int().min(1).max(10000),
  gross_amount: z.coerce.number().int().min(1),
});

export async function POST(req: NextRequest) {
  const BUY_PAGE_TENANT_ID = websiteTenantId();
  if (!BUY_PAGE_TENANT_ID) return NextResponse.json(websiteTenantMissingBody(), { status: 503 });
  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, reason: "bad_request", message: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }
  const { code, tier, seats, gross_amount } = parsed.data;

  const admin = createAdminClient();

  // Dry-run: load coupon + compute discount, but DON'T record redemption.
  // We replicate the validation logic from the redeem_coupon RPC to keep
  // counter integrity. Real redemption only happens at checkout time.
  const { data: coupon, error } = await admin
    .from("coupons")
    .select("*")
    .eq("code", code.toUpperCase().trim())
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .maybeSingle();

  if (error) {
    const e = publicDbError("coupons/validate", error, "We could not check this coupon just now. Please try again in a minute, or continue without it.");
    return NextResponse.json({ ok: false, reason: "server_error", message: e.message }, { status: e.status });
  }
  if (!coupon) {
    return NextResponse.json({ ok: false, reason: "invalid_code" }, { status: 200 });
  }

  const now = new Date();
  if (!coupon.is_active) {
    return NextResponse.json({ ok: false, reason: "inactive" }, { status: 200 });
  }
  if (new Date(coupon.valid_from) > now) {
    return NextResponse.json({ ok: false, reason: "not_started" }, { status: 200 });
  }
  if (coupon.valid_until && new Date(coupon.valid_until) < now) {
    return NextResponse.json({ ok: false, reason: "expired" }, { status: 200 });
  }
  if (coupon.max_redemptions !== null && coupon.redemption_count >= coupon.max_redemptions) {
    return NextResponse.json({ ok: false, reason: "maxed_out" }, { status: 200 });
  }
  if (coupon.applies_to_tier && coupon.applies_to_tier.toLowerCase() !== tier.toLowerCase()) {
    return NextResponse.json(
      { ok: false, reason: "wrong_tier", required_tier: coupon.applies_to_tier },
      { status: 200 }
    );
  }
  if (seats < coupon.min_seats) {
    return NextResponse.json(
      { ok: false, reason: "min_seats_not_met", min_seats: coupon.min_seats },
      { status: 200 }
    );
  }
  if (coupon.max_seats !== null && seats > coupon.max_seats) {
    return NextResponse.json(
      { ok: false, reason: "max_seats_exceeded", max_seats: coupon.max_seats },
      { status: 200 }
    );
  }

  // Compute discount — clamped to gross
  const rawDiscount = coupon.discount_type === "percent"
    ? Math.round(gross_amount * coupon.discount_value / 100)
    : coupon.discount_value;
  const discount = Math.min(rawDiscount, gross_amount);

  return NextResponse.json({
    ok:             true,
    code:           coupon.code,
    discount,
    discount_type:  coupon.discount_type,
    discount_value: coupon.discount_value,
    description:    coupon.description,
  });
}
