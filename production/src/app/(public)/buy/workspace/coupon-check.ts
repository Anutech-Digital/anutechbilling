/**
 * Coupon check for the Workspace buy dialog (R-1630).
 *
 * One call to the dry-run validator (/api/public/coupons/validate — the server re-validates at
 * checkout anyway). Used by "Apply" and again whenever seats or plan change: before R-1630 a
 * change cleared the coupon silently and the discount vanished from the total with no word.
 */

/** A coupon the validator accepted — the pre-GST rupee discount for the current basket. */
export interface AppliedCoupon {
  code:           string;
  discount:       number;       // pre-GST rupees off
  discount_type:  "percent" | "flat";
  discount_value: number;
  description?:   string | null;
}

export interface CouponRequest {
  code: string;
  tier: string;
  seats: number;
  /** Pre-GST subtotal after the site promo — the coupon stacks below it. */
  gross_amount: number;
}

export type CouponCheck = { ok: true; coupon: AppliedCoupon } | { ok: false; message: string };

interface ValidateJson {
  ok?: boolean;
  reason?: string;
  message?: string;
  required_tier?: string;
  min_seats?: number;
  max_seats?: number;
  code?: string;
  discount?: number;
  discount_type?: "percent" | "flat";
  discount_value?: number;
  description?: string | null;
}

/** Why the validator refused, in the buyer's words. */
export function couponRefusal(json: ValidateJson): string {
  const friendly: Record<string, string> = {
    invalid_code:        "That code doesn't exist",
    inactive:            "This coupon is no longer active",
    expired:             "This coupon has expired",
    not_started:         "This coupon isn't active yet",
    maxed_out:           "This coupon has reached its usage limit",
    wrong_tier:          json.required_tier ? `Code is only for the ${json.required_tier} tier` : "Code doesn't apply to this tier",
    min_seats_not_met:   `Needs at least ${json.min_seats ?? "more"} seats`,
    max_seats_exceeded:  `Code only works up to ${json.max_seats ?? "fewer"} seats`,
    bad_request:         json.message ?? "Invalid request",
    server_error:        "Server error — try again",
  };
  return friendly[json.reason ?? ""] ?? "Could not apply this code";
}

/** Ask the validator about one code for one basket. Throws only on a network failure. */
export async function checkCoupon(req: CouponRequest, fetchImpl: typeof fetch = fetch): Promise<CouponCheck> {
  const res = await fetchImpl("/api/public/coupons/validate", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const json = (await res.json()) as ValidateJson;
  if (!json.ok) return { ok: false, message: couponRefusal(json) };
  return {
    ok: true,
    coupon: {
      code:           json.code ?? req.code,
      discount:       json.discount ?? 0,
      discount_type:  json.discount_type ?? "flat",
      discount_value: json.discount_value ?? 0,
      description:    json.description ?? null,
    },
  };
}

/**
 * After seats or plan change: check the applied code again for the new basket.
 * Still valid → keep it (new discount). Not valid → remove it and say why.
 */
export async function recheckCoupon(
  applied: AppliedCoupon, req: CouponRequest, fetchImpl: typeof fetch = fetch,
): Promise<{ applied: AppliedCoupon | null; error: string | null }> {
  try {
    const r = await checkCoupon({ ...req, code: applied.code }, fetchImpl);
    if (r.ok) return { applied: r.coupon, error: null };
    return { applied: null, error: `Coupon ${applied.code} removed — ${r.message}` };
  } catch {
    return { applied: null, error: `Coupon ${applied.code} could not be checked for the new plan or seats — apply it again` };
  }
}
