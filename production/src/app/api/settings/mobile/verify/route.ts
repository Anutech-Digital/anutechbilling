/**
 * POST /api/settings/mobile/verify  { phone, code } — R-1903: check the code; when right, the
 * number is saved on MY login and marked verified — one atomic RPC (verify_phone_otp, §17b)
 * that also counts wrong tries (3 → 15-minute lock) and writes the audit line.
 */
import { hashOtp, isOtpShape, otpHashSecret } from "@/lib/sms/otp";
import { SMS_NOT_SET_UP } from "@/lib/sms/gateway";
import { otpMessage, otpStatus } from "@/lib/sms/otp-messages";
import { normalizeIndianMobile } from "@/lib/sms/phone";
import { noStore, otpCaller, readBody, rpcClient, rpcFailure, SESSION_ENDED } from "@/lib/sms/otp-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface VerifyReply {
  ok: boolean; reason?: string; retry_after_seconds?: number; tries_left?: number;
  phone?: string; phone_verified_at?: string;
}

export async function POST(req: Request) {
  const me = await otpCaller();
  if (!me) return noStore({ error: SESSION_ENDED }, 401);

  const body = await readBody(req);
  const phone = normalizeIndianMobile(typeof body.phone === "string" ? body.phone : "");
  if (!phone) return noStore({ error: otpMessage({ reason: "invalid_phone" }), reason: "invalid_phone" }, 400);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  // A typo in the shape is not a wrong try: the database is not asked.
  if (!isOtpShape(code)) return noStore({ error: "Type the 6-digit code from the SMS (numbers only)." }, 400);

  const secret = otpHashSecret();
  if (!secret) return noStore({ error: SMS_NOT_SET_UP, code: "sms_not_set_up" }, 503);

  const { data, error } = await rpcClient(me.db).rpc<VerifyReply>("verify_phone_otp", {
    p_phone: phone, p_code_hash: hashOtp(secret, me.userId, phone, code),
  });
  if (error || !data) return rpcFailure(error ?? {});
  if (!data.ok) {
    const reason = data.reason ?? "unknown";
    return noStore({
      error: otpMessage({ reason, retry_after_seconds: data.retry_after_seconds, tries_left: data.tries_left }),
      reason, triesLeft: data.tries_left ?? null, retryAfterSeconds: data.retry_after_seconds ?? null,
    }, otpStatus(reason));
  }
  return noStore({ ok: true, phone: data.phone ?? phone, verifiedAt: data.phone_verified_at ?? null });
}
