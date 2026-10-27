/**
 * POST /api/settings/mobile/send  { phone } — R-1903: send a 6-digit code to verify MY number.
 *
 * Order matters:
 *   1. the number is checked, and the SMS gateway must be ready — on staging/live without an
 *      SMS provider the answer is "SMS is not set up yet" and NOTHING is stored or counted;
 *   2. request_phone_otp stores the HMAC (never the code), applies the 30 s / 5-per-hour /
 *      lock rules and writes the audit line with the masked number;
 *   3. the gateway sends; if it fails the code is voided (cancel_phone_otp) and we say so.
 * Only the dev gateway (never on a deployment) hands the code back for the screen.
 */
import { devSmsAllowed, smsGateway, SMS_NOT_SET_UP } from "@/lib/sms/gateway";
import { generateOtp, hashOtp, otpHashSecret, otpSmsText } from "@/lib/sms/otp";
import { otpMessage, otpStatus } from "@/lib/sms/otp-messages";
import { maskPhone, normalizeIndianMobile } from "@/lib/sms/phone";
import { noStore, otpCaller, readBody, rpcClient, rpcFailure, SESSION_ENDED } from "@/lib/sms/otp-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RequestReply {
  ok: boolean; reason?: string; retry_after_seconds?: number;
  otp_id?: string; expires_at?: string; resend_after_seconds?: number;
}

export async function POST(req: Request) {
  const me = await otpCaller();
  if (!me) return noStore({ error: SESSION_ENDED }, 401);

  const body = await readBody(req);
  const phone = normalizeIndianMobile(typeof body.phone === "string" ? body.phone : "");
  if (!phone) return noStore({ error: otpMessage({ reason: "invalid_phone" }), reason: "invalid_phone" }, 400);

  const gw = smsGateway();
  const secret = otpHashSecret();
  if (!gw.ready || !secret) return noStore({ error: SMS_NOT_SET_UP, code: "sms_not_set_up" }, 503);

  const code = generateOtp();
  const db = rpcClient(me.db);
  const { data, error } = await db.rpc<RequestReply>("request_phone_otp", {
    p_phone: phone, p_code_hash: hashOtp(secret, me.userId, phone, code),
  });
  if (error || !data) return rpcFailure(error ?? {});
  if (!data.ok) {
    const reason = data.reason ?? "unknown";
    return noStore({ error: otpMessage({ reason, retry_after_seconds: data.retry_after_seconds }), reason,
                     retryAfterSeconds: data.retry_after_seconds ?? null }, otpStatus(reason));
  }

  let sent: Awaited<ReturnType<typeof gw.send>>;
  try {
    sent = await gw.send(phone, otpSmsText(code));
  } catch {
    sent = { ok: false, reason: "failed", message: "" };
  }
  if (!sent.ok) {
    if (data.otp_id) await db.rpc("cancel_phone_otp", { p_otp_id: data.otp_id });
    return noStore({
      error: sent.message || "The SMS could not be sent, so that code will not work. Wait a minute and press Verify again.",
    }, 502);
  }

  return noStore({
    ok: true,
    sentTo: maskPhone(phone),
    expiresAt: data.expires_at ?? null,
    resendAfterSeconds: data.resend_after_seconds ?? 30,
    // Local/test only: no SMS exists there, so the person testing reads the code on screen.
    ...(gw.name === "dev" && devSmsAllowed() ? { devCode: code } : {}),
  });
}
